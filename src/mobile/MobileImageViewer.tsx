import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Loader2, RotateCw, X } from 'lucide-react';
import { sftpPreviewImage, sftpPreviewCleanup } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import MobileFullscreenPage from './ui/MobileFullscreenPage';
import {
  clampPan,
  doubleTapTargetScale,
  fitScale,
  pinchOf,
  zoomAt,
  type ZoomView,
} from './gestures';

interface MobileImageViewerProps {
  open: boolean;
  sessionId: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
}

interface PreviewProgress {
  previewId: string;
  written: number;
  total: number;
}

const MIN_SCALE_FACTOR = 0.5; // relative to fit
const MAX_SCALE = 8;
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
  sessionId,
  filePath,
  fileName,
  fileSize,
  onClose,
}: MobileImageViewerProps) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{
    written: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const [view, setView] = useState<ZoomView>(INITIAL_VIEW);
  const [rotation, setRotation] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const localPathRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
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
    setView({ scale: currentFitScale(), translateX: 0, translateY: 0 });
  }, [currentFitScale]);

  const cleanupLocal = useCallback(async () => {
    const p = localPathRef.current;
    if (p) {
      localPathRef.current = null;
      try {
        await sftpPreviewCleanup(p);
      } catch {
        // 残留由启动清理兜底
      }
    }
  }, []);

  // Load image via SFTP preview (same IPC + cleanup contract as desktop).
  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setProgress(null);
    setError(null);
    setImageSrc(null);
    setNaturalSize(null);
    setView(INITIAL_VIEW);
    setRotation(0);
    setChromeVisible(true);
    cancelledRef.current = false;

    const previewId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let unlistenProgress: UnlistenFn | null = null;

    (async () => {
      unlistenProgress = await listen<PreviewProgress>(
        'sftp-preview-progress',
        (e) => {
          if (e.payload.previewId !== previewId) return;
          setProgress({ written: e.payload.written, total: e.payload.total });
        },
      );

      try {
        const result = await sftpPreviewImage(sessionId, filePath, previewId);
        if (cancelledRef.current) {
          localPathRef.current = result.localPath;
          await cleanupLocal();
          return;
        }
        localPathRef.current = result.localPath;
        setImageSrc(convertFileSrc(result.localPath));
      } catch (err) {
        if (cancelledRef.current) return;
        setError(getErrorMessage(err));
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelledRef.current = true;
      if (unlistenProgress) unlistenProgress();
      void cleanupLocal();
    };
  }, [open, sessionId, filePath, cleanupLocal]);

  const handleImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      naturalRef.current = { w: img.naturalWidth, h: img.naturalHeight };
      applyFit();
    },
    [applyFit],
  );

  const handleRotate = useCallback(() => {
    const next = (rotationRef.current + 90) % 360;
    rotationRef.current = next;
    setRotation(next);
    // Refit against the new rotation immediately (refs are already updated).
    const el = containerRef.current;
    const nat = naturalRef.current;
    if (el && nat) {
      const rect = el.getBoundingClientRect();
      setView({
        scale: fitScale(nat.w, nat.h, rect.width, rect.height, next),
        translateX: 0,
        translateY: 0,
      });
    }
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    movedRef.current = false;
    if (e.touches.length === 2) {
      const p = pinchOf(
        { x: e.touches[0].clientX, y: e.touches[0].clientY },
        { x: e.touches[1].clientX, y: e.touches[1].clientY },
      );
      pinchStartRef.current = { distance: p.distance, view: viewRef.current };
      panStartRef.current = null;
      lastTapRef.current = null;
      return;
    }
    if (e.touches.length === 1) {
      panStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        view: viewRef.current,
      };
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const el = containerRef.current;
      if (!el) return;
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
        setView(clampView(next));
        return;
      }

      if (e.touches.length === 1 && panStartRef.current) {
        const start = panStartRef.current;
        const dx = e.touches[0].clientX - start.x;
        const dy = e.touches[0].clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) movedRef.current = true;
        // Only pan when zoomed beyond fit — otherwise leave gesture inert.
        if (start.view.scale > currentFitScale() * 1.01) {
          setView(
            clampView({
              scale: start.view.scale,
              translateX: start.view.translateX + dx,
              translateY: start.view.translateY + dy,
            }),
          );
        }
      }
    },
    [clampView, currentFitScale],
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
        lastTapRef.current = null;
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
        lastTapRef.current = null;
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
          setView({ scale: fit, translateX: 0, translateY: 0 });
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
          setView(clampView(next));
        }
        return;
      }

      lastTapRef.current = { time: now, x: start.x, y: start.y };
      // Single tap toggles chrome after double-tap window passes.
      setTimeout(() => {
        if (lastTapRef.current && lastTapRef.current.time === now) {
          lastTapRef.current = null;
          setChromeVisible((v) => !v);
        }
      }, DOUBLE_TAP_MS);
    },
    [clampView, currentFitScale],
  );

  if (!open) return null;

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.written / progress.total) * 100))
      : 0;

  const transform = `translate(${view.translateX}px, ${view.translateY}px) scale(${view.scale}) rotate(${rotation}deg)`;
  const zoomPct = naturalSize ? Math.round(view.scale * 100) : null;

  return (
    <MobileFullscreenPage
      region="mobile-image-viewer"
      className="bg-black"
      closing={closing}
      onExitAnimationEnd={onExitAnimationEnd}
      onBack={requestClose}
    >
      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {imageSrc && (
          <div className="absolute inset-0 flex items-center justify-center">
            <img
              src={imageSrc}
              alt={fileName}
              onLoad={handleImgLoad}
              draggable={false}
              className="max-h-none max-w-none select-none"
              style={{ transform }}
            />
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载图片…
            </div>
            {progress && progress.total > 0 && (
              <div className="flex w-56 flex-col gap-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full bg-indigo-500 transition-all duration-200"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-zinc-500">
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
            <p className="break-words text-center text-sm text-red-300">
              {error}
            </p>
            <button
              type="button"
              onClick={requestClose}
              className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 active:bg-zinc-700"
            >
              关闭
            </button>
          </div>
        )}
      </div>

      {/* Top chrome */}
      {chromeVisible && (
        <div
          className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/85 to-transparent px-3 pb-6"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-zinc-100">
              {fileName}
            </div>
            <div className="text-[11px] text-zinc-400">
              {formatSize(fileSize)}
              {naturalSize ? ` · ${naturalSize.w}×${naturalSize.h}` : ''}
              {zoomPct != null ? ` · ${zoomPct}%` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={handleRotate}
            disabled={!imageSrc}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
            aria-label="旋转"
          >
            <RotateCw className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={requestClose}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-200 active:bg-zinc-700"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </MobileFullscreenPage>
  );
}
