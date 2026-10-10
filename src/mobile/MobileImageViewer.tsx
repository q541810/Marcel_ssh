import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Loader2, Maximize, Minus, Plus, RotateCw, X } from 'lucide-react';
import { formatSize } from '@/lib/sftp-helpers';
import type { ImagePreviewProps } from '@/lib/imagePreview';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import { useImagePreviewSource } from '@/hooks/useImagePreviewSource';
import { usePreviewDialogFocus } from '@/hooks/usePreviewDialogFocus';
import MobileFullscreenPage from './ui/MobileFullscreenPage';
import {
  clampPan,
  doubleTapTargetScale,
  fitScale,
  pinchOf,
  zoomAt,
  type ZoomView,
} from './gestures';

const MIN_SCALE_FACTOR = 0.5; // relative to fit
const MAX_SCALE = 8;
const BUTTON_SCALE_STEP = 1.25;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;

const INITIAL_VIEW: ZoomView = { scale: 1, translateX: 0, translateY: 0 };

/**
 * Full-screen touch-first image viewer for the mobile shell.
 * Pinch to zoom, one-finger pan when zoomed, double-tap to toggle zoom,
 * rotate button. Replaces the desktop ImagePreviewModal on mobile.
 */
export default function MobileImageViewer({
  open,
  source,
  fileName,
  fileSize,
  onClose,
}: ImagePreviewProps) {
  const { imageSrc, loading, progress, error, onImageError } =
    useImagePreviewSource({
      open,
      source,
      fileSize,
    });
  const [loadedImage, setLoadedImage] = useState<{
    src: string;
    w: number;
    h: number;
  } | null>(null);
  const naturalSize = loadedImage?.src === imageSrc ? loadedImage : null;
  const [view, setView] = useState<ZoomView>(INITIAL_VIEW);
  const [rotation, setRotation] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);

  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastFitRef = useRef(1);
  const {
    closing,
    requestClose,
    onAnimationEnd: onExitAnimationEnd,
  } = useAnimatedClose(onClose);

  const viewRef = useRef(view);
  viewRef.current = view;
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
  const naturalRef = useRef(naturalSize);
  naturalRef.current = naturalSize;

  // Gesture bookkeeping
  const pinchStartRef = useRef<{ distance: number; view: ZoomView } | null>(
    null,
  );
  const panStartRef = useRef<{ x: number; y: number; view: ZoomView } | null>(
    null,
  );
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(
    null,
  );
  const movedRef = useRef(false);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTap = useCallback(() => {
    if (tapTimerRef.current != null) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = null;
    lastTapRef.current = null;
  }, []);

  const clearGesture = useCallback(() => {
    clearTap();
    pinchStartRef.current = null;
    panStartRef.current = null;
    movedRef.current = false;
  }, [clearTap]);

  const handleClose = useCallback(() => {
    clearGesture();
    requestClose();
  }, [clearGesture, requestClose]);

  usePreviewDialogFocus({
    open,
    mobile: true,
    dialogRef,
    initialFocusRef: closeRef,
    onClose: handleClose,
  });

  useLayoutEffect(() => {
    // 隐藏工具栏会卸载当前聚焦的关闭按钮，焦点继续留在画布内。
    if (
      open &&
      !chromeVisible &&
      !dialogRef.current?.contains(document.activeElement)
    ) {
      containerRef.current?.focus({ preventScroll: true });
    }
  }, [open, chromeVisible]);

  const updateView = useCallback((next: ZoomView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  // A changed source (including a fallback) starts with its own geometry and gestures.
  useLayoutEffect(() => {
    setLoadedImage(null);
    naturalRef.current = null;
    rotationRef.current = 0;
    lastFitRef.current = 1;
    updateView(INITIAL_VIEW);
    setRotation(0);
    setChromeVisible(true);
    clearGesture();
    return clearGesture;
  }, [open, imageSrc, clearGesture, updateView]);

  const currentFitScale = useCallback((): number => {
    const el = containerRef.current;
    const nat = naturalRef.current;
    if (!el || !nat) return 1;
    const rect = el.getBoundingClientRect();
    return fitScale(nat.w, nat.h, rect.width, rect.height, rotationRef.current);
  }, []);

  const clampView = useCallback((v: ZoomView): ZoomView => {
    const el = containerRef.current;
    const nat = naturalRef.current;
    if (!el || !nat) return v;
    const rect = el.getBoundingClientRect();
    const rotated = rotationRef.current % 180 !== 0;
    const w = rotated ? nat.h : nat.w;
    const h = rotated ? nat.w : nat.h;
    const { x, y } = clampPan(
      v.translateX,
      v.translateY,
      w,
      h,
      rect.width,
      rect.height,
      v.scale,
    );
    return { scale: v.scale, translateX: x, translateY: y };
  }, []);

  const applyFit = useCallback(() => {
    if (!naturalRef.current) return;
    clearGesture();
    const fit = currentFitScale();
    lastFitRef.current = fit;
    updateView({ scale: fit, translateX: 0, translateY: 0 });
  }, [clearGesture, currentFitScale, updateView]);

  const zoomAtCenter = useCallback(
    (factor: number) => {
      if (!naturalRef.current) return;
      clearGesture();
      updateView(
        clampView(
          zoomAt(viewRef.current, {
            anchorX: 0,
            anchorY: 0,
            factor,
            minScale: currentFitScale() * MIN_SCALE_FACTOR,
            maxScale: MAX_SCALE,
          }),
        ),
      );
    },
    [clampView, clearGesture, currentFitScale, updateView],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!open || !el || !naturalSize || typeof ResizeObserver === 'undefined')
      return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const wasFit =
        Math.abs(viewRef.current.scale - lastFitRef.current) < 0.001;
      const fit = currentFitScale();
      lastFitRef.current = fit;
      clearGesture();
      updateView(
        wasFit
          ? { scale: fit, translateX: 0, translateY: 0 }
          : clampView({
              ...viewRef.current,
              scale: Math.max(fit * MIN_SCALE_FACTOR, viewRef.current.scale),
            }),
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, naturalSize, clampView, clearGesture, currentFitScale, updateView]);

  const handleImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      if (!imageSrc || !img.isConnected || img.getAttribute('src') !== imageSrc)
        return;
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        onImageError();
        return;
      }
      const natural = {
        src: imageSrc,
        w: img.naturalWidth,
        h: img.naturalHeight,
      };
      setLoadedImage(natural);
      naturalRef.current = natural;
      applyFit();
    },
    [imageSrc, applyFit, onImageError],
  );

  const handleRotate = useCallback(() => {
    if (!naturalRef.current) return;
    clearGesture();
    const next = (rotationRef.current + 90) % 360;
    rotationRef.current = next;
    setRotation(next);
    // Refit against the new rotation immediately (refs are already updated).
    const el = containerRef.current;
    const nat = naturalRef.current;
    if (el && nat) {
      const rect = el.getBoundingClientRect();
      const fit = fitScale(nat.w, nat.h, rect.width, rect.height, next);
      lastFitRef.current = fit;
      updateView({
        scale: fit,
        translateX: 0,
        translateY: 0,
      });
    }
  }, [clearGesture, updateView]);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!naturalRef.current || closing) return;
      movedRef.current = false;
      if (e.touches.length === 2) {
        const p = pinchOf(
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        );
        pinchStartRef.current = { distance: p.distance, view: viewRef.current };
        panStartRef.current = null;
        clearTap();
        return;
      }
      if (e.touches.length === 1) {
        panStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          view: viewRef.current,
        };
      }
    },
    [clearTap, closing],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const el = containerRef.current;
      if (!el || !naturalRef.current) return;
      const rect = el.getBoundingClientRect();

      if (e.touches.length === 2 && pinchStartRef.current) {
        movedRef.current = true;
        const p = pinchOf(
          { x: e.touches[0].clientX, y: e.touches[0].clientY },
          { x: e.touches[1].clientX, y: e.touches[1].clientY },
        );
        const start = pinchStartRef.current;
        if (start.distance <= 0) return;
        const factor = p.distance / start.distance;
        const anchorX = p.centerX - rect.left - rect.width / 2;
        const anchorY = p.centerY - rect.top - rect.height / 2;
        const fit = currentFitScale();
        const next = zoomAt(start.view, {
          anchorX,
          anchorY,
          factor,
          minScale: fit * MIN_SCALE_FACTOR,
          maxScale: MAX_SCALE,
        });
        updateView(clampView(next));
        return;
      }

      if (e.touches.length === 1 && panStartRef.current) {
        const start = panStartRef.current;
        const dx = e.touches[0].clientX - start.x;
        const dy = e.touches[0].clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) {
          movedRef.current = true;
          clearTap();
        }
        // Only pan when zoomed beyond fit — otherwise leave gesture inert.
        if (start.view.scale > currentFitScale() * 1.01) {
          updateView(
            clampView({
              scale: start.view.scale,
              translateX: start.view.translateX + dx,
              translateY: start.view.translateY + dy,
            }),
          );
        }
      }
    },
    [clampView, clearTap, currentFitScale, updateView],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length < 2) pinchStartRef.current = null;
      if (e.touches.length === 1) {
        // Pinch → single finger: re-seed pan start so the remaining finger
        // pans from here instead of jumping to the stale pre-pinch origin.
        panStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          view: viewRef.current,
        };
        movedRef.current = true;
        return;
      }
      if (e.touches.length > 0) return;

      const start = panStartRef.current;
      panStartRef.current = null;

      // Tap detection (no significant movement).
      if (!start || movedRef.current) {
        clearTap();
        return;
      }

      const now = Date.now();
      const last = lastTapRef.current;
      const isDouble =
        last &&
        now - last.time <= DOUBLE_TAP_MS &&
        Math.abs(start.x - last.x) <= DOUBLE_TAP_SLOP_PX &&
        Math.abs(start.y - last.y) <= DOUBLE_TAP_SLOP_PX;

      if (isDouble) {
        clearTap();
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const fit = currentFitScale();
        const target = doubleTapTargetScale(
          viewRef.current.scale,
          fit,
          fit * DOUBLE_TAP_ZOOM,
        );
        if (target === fit) {
          updateView({ scale: fit, translateX: 0, translateY: 0 });
        } else {
          const anchorX = start.x - rect.left - rect.width / 2;
          const anchorY = start.y - rect.top - rect.height / 2;
          const next = zoomAt(viewRef.current, {
            anchorX,
            anchorY,
            factor: target / viewRef.current.scale,
            minScale: fit * MIN_SCALE_FACTOR,
            maxScale: MAX_SCALE,
          });
          updateView(clampView(next));
        }
        return;
      }

      clearTap();
      lastTapRef.current = { time: now, x: start.x, y: start.y };
      // Single tap toggles chrome after double-tap window passes.
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = null;
        if (lastTapRef.current && lastTapRef.current.time === now) {
          lastTapRef.current = null;
          setChromeVisible((v) => !v);
        }
      }, DOUBLE_TAP_MS);
    },
    [clampView, clearTap, currentFitScale, updateView],
  );

  if (!open) return null;

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.written / progress.total) * 100))
      : 0;

  const transform = `translate(${view.translateX}px, ${view.translateY}px) scale(${view.scale}) rotate(${rotation}deg)`;
  const zoomPct = naturalSize ? Math.round(view.scale * 100) : null;
  const imageLoading = loading || Boolean(imageSrc && !naturalSize && !error);
  const hasSize =
    typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize >= 0;
  const details = [
    hasSize ? formatSize(fileSize) : null,
    naturalSize ? `${naturalSize.w}×${naturalSize.h}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const actionClass =
    'flex h-12 w-12 min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-black/70 text-white active:bg-white/20 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white';

  return (
    <MobileFullscreenPage
      region="mobile-image-viewer"
      className="bg-black"
      closing={closing}
      onExitAnimationEnd={onExitAnimationEnd}
      onBack={handleClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex min-h-0 flex-1 flex-col"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          {fileName}
        </h2>
        {/* Keep the existing touch canvas; source loading is shared with desktop. */}
        <div
          ref={containerRef}
          role="group"
          aria-label="图片预览"
          aria-busy={imageLoading}
          tabIndex={0}
          className="relative min-h-0 flex-1 touch-none overflow-hidden focus-visible:outline-offset-[-2px] focus-visible:outline-white"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={clearGesture}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              zoomAtCenter(BUTTON_SCALE_STEP);
            } else if (event.key === '-') {
              event.preventDefault();
              zoomAtCenter(1 / BUTTON_SCALE_STEP);
            } else if (event.key === '0') {
              event.preventDefault();
              applyFit();
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setChromeVisible((visible) => !visible);
            }
          }}
        >
          {imageSrc && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <img
                key={imageSrc}
                src={imageSrc}
                alt={fileName}
                onLoad={handleImgLoad}
                onError={onImageError}
                draggable={false}
                className="max-h-none max-w-none select-none"
                style={{ transform, opacity: naturalSize ? 1 : 0 }}
              />
            </div>
          )}

          {imageLoading && (
            <div
              role="status"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black"
            >
              <div className="flex items-center gap-2 text-sm text-white/70">
                <Loader2
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                />
                正在加载图片…
              </div>
              {progress && progress.total > 0 && (
                <div className="flex w-56 flex-col gap-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
                    <div
                      className="h-full bg-indigo-500 transition-all duration-200 motion-reduce:transition-none"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-white/70">
                    <span>
                      {formatSize(progress.written)} /{' '}
                      {formatSize(progress.total)}
                    </span>
                    <span>{progressPct}%</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {error && !loading && (
            <div
              role="alert"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6"
            >
              <p className="break-words text-center text-sm text-white">
                {error}
              </p>
              <button
                type="button"
                onClick={handleClose}
                className="min-h-12 rounded-lg bg-white/15 px-4 py-2 text-sm text-white active:bg-white/25 focus-visible:outline-white"
              >
                关闭
              </button>
            </div>
          )}
        </div>

        {chromeVisible && (
          <>
            {/* Top chrome retains the established name, rotate, close layout. */}
            <div
              className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/85 to-transparent px-3 pb-6"
              style={{
                paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))',
              }}
            >
              <div className="min-w-0 flex-1">
                <div
                  aria-hidden="true"
                  className="truncate text-sm font-medium text-white"
                  title={fileName}
                >
                  {fileName}
                </div>
                {details && (
                  <div className="text-xs text-white/70">{details}</div>
                )}
              </div>
              <button
                type="button"
                onClick={handleRotate}
                disabled={!naturalSize}
                className={actionClass}
                aria-label="旋转"
              >
                <RotateCw aria-hidden="true" className="h-5 w-5" />
              </button>
              <button
                ref={closeRef}
                type="button"
                onClick={handleClose}
                className={actionClass}
                aria-label="关闭"
              >
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-gradient-to-t from-black/90 to-transparent px-3 pb-2 pt-6">
              <span className="text-xs text-white/70">
                双指缩放，放大后拖动
              </span>
              <div className="flex max-w-full items-center gap-2">
                <button
                  type="button"
                  aria-label="缩小图片"
                  className={actionClass}
                  disabled={
                    !naturalSize ||
                    view.scale <= lastFitRef.current * MIN_SCALE_FACTOR + 0.001
                  }
                  onClick={() => zoomAtCenter(1 / BUTTON_SCALE_STEP)}
                >
                  <Minus aria-hidden="true" className="h-5 w-5" />
                </button>
                <output
                  aria-label="图片缩放比例"
                  className="min-w-10 shrink-0 text-center text-sm tabular-nums text-white"
                >
                  {zoomPct != null ? `${zoomPct}%` : '—'}
                </output>
                <button
                  type="button"
                  aria-label="放大图片"
                  className={actionClass}
                  disabled={!naturalSize || view.scale >= MAX_SCALE}
                  onClick={() => zoomAtCenter(BUTTON_SCALE_STEP)}
                >
                  <Plus aria-hidden="true" className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="适应窗口"
                  className={actionClass}
                  disabled={!naturalSize}
                  onClick={applyFit}
                >
                  <Maximize aria-hidden="true" className="h-5 w-5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </MobileFullscreenPage>
  );
}
