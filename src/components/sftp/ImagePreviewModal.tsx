import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useId,
} from 'react';
import { createPortal } from 'react-dom';
import { formatSize } from '@/lib/sftp-helpers';
import type { ImagePreviewProps } from '@/lib/imagePreview';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import { useImagePreviewSource } from '@/hooks/useImagePreviewSource';
import { usePreviewDialogFocus } from '@/hooks/usePreviewDialogFocus';

// 缩放范围
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
// 单次滚轮缩放倍率
const WHEEL_SCALE_STEP = 1.15;
// 按钮缩放倍率
const BUTTON_SCALE_STEP = 1.25;

type FitMode = 'fit' | 'actual' | 'custom';

interface ViewState {
  scale: number;
  translateX: number;
  translateY: number;
  rotation: number; // 0/90/180/270
  flipH: boolean;
  flipV: boolean;
}

const INITIAL_STATE: ViewState = {
  scale: 1,
  translateX: 0,
  translateY: 0,
  rotation: 0,
  flipH: false,
  flipV: false,
};

export default function ImagePreviewModal({
  open,
  source,
  fileName,
  fileSize,
  onClose,
}: ImagePreviewProps) {
  const { loading, progress, error, imageSrc, onImageError } =
    useImagePreviewSource({ open, source, fileSize });
  const [imgNaturalSize, setImgNaturalSize] = useState<{
    w: number;
    h: number;
  } | null>(null);
  const [view, setView] = useState<ViewState>(INITIAL_STATE);
  const [fitMode, setFitMode] = useState<FitMode>('fit');
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const {
    closing,
    requestClose,
    onAnimationEnd: onExitAnimationEnd,
  } = useAnimatedClose(onClose);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
  } | null>(null);
  const viewRef = useRef<ViewState>(INITIAL_STATE);
  const fitModeRef = useRef<FitMode>('fit');

  viewRef.current = view;
  fitModeRef.current = fitMode;
  const hasSize =
    typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize >= 0;
  const imageReady = imageSrc !== null && imgNaturalSize !== null && !error;
  const imageLoading =
    loading || (imageSrc !== null && imgNaturalSize === null && !error);
  usePreviewDialogFocus({
    open,
    dialogRef,
    initialFocusRef: closeRef,
    onClose: requestClose,
  });

  const reset = useCallback(() => {
    setImgNaturalSize(null);
    setView(INITIAL_STATE);
    setFitMode('fit');
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  useLayoutEffect(reset, [open, imageSrc, reset]);

  // 计算适应窗口的缩放倍率
  const computeFitScale = useCallback(
    (rotation = viewRef.current.rotation): number => {
      const img = imgRef.current;
      const container = containerRef.current;
      if (!img || !container) return 1;
      const imgW = img.naturalWidth;
      const imgH = img.naturalHeight;
      if (!imgW || !imgH) return 1;
      const containerRect = container.getBoundingClientRect();
      if (containerRect.width <= 0 || containerRect.height <= 0)
        return viewRef.current.scale;
      // 旋转 90/270 时宽高对调
      const isRotated = rotation % 180 !== 0;
      const effectiveW = isRotated ? imgH : imgW;
      const effectiveH = isRotated ? imgW : imgH;
      const scaleW = containerRect.width / effectiveW;
      const scaleH = containerRect.height / effectiveH;
      return Math.min(scaleW, scaleH, 1);
    },
    [],
  );

  // 应用适应窗口
  const applyFit = useCallback(() => {
    const scale = computeFitScale();
    setView((v) => ({ ...v, scale, translateX: 0, translateY: 0 }));
    setFitMode('fit');
  }, [computeFitScale]);

  useEffect(() => {
    const container = containerRef.current;
    if (
      !open ||
      !container ||
      !imgNaturalSize ||
      typeof ResizeObserver === 'undefined'
    )
      return;
    const observer = new ResizeObserver(() => {
      if (fitModeRef.current === 'fit') applyFit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [open, imgNaturalSize, applyFit]);

  // 应用实际大小
  const applyActual = useCallback(() => {
    setView((v) => ({ ...v, scale: 1, translateX: 0, translateY: 0 }));
    setFitMode('actual');
  }, []);

  // 缩放（以容器中心为锚点）
  const zoomAtCenter = useCallback((delta: number) => {
    setView((v) => {
      const newScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, v.scale * delta),
      );
      if (newScale === v.scale) return v;
      // 以容器中心为锚点缩放
      return {
        ...v,
        scale: newScale,
        translateX: v.translateX * (newScale / v.scale),
        translateY: v.translateY * (newScale / v.scale),
      };
    });
    setFitMode('custom');
  }, []);

  // 缩放（以鼠标位置为锚点）
  const zoomAtPoint = useCallback(
    (mouseX: number, mouseY: number, delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cx = mouseX - rect.left - rect.width / 2;
      const cy = mouseY - rect.top - rect.height / 2;
      setView((v) => {
        const newScale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, v.scale * delta),
        );
        if (newScale === v.scale) return v;
        // 鼠标在图片坐标系中的位置（缩放前）：(cx - tx) / scale
        // 缩放后要保持该点在鼠标下：newTx = cx - (cx - tx) * (newScale / scale)
        const ratio = newScale / v.scale;
        return {
          ...v,
          scale: newScale,
          translateX: cx - (cx - v.translateX) * ratio,
          translateY: cy - (cy - v.translateY) * ratio,
        };
      });
      setFitMode('custom');
    },
    [],
  );

  // 旋转
  const rotate = useCallback(
    (direction: 1 | -1) => {
      setView((v) => {
        const rotation = (((v.rotation + direction * 90) % 360) + 360) % 360;
        return {
          ...v,
          rotation,
          scale: computeFitScale(rotation),
          translateX: 0,
          translateY: 0,
        };
      });
      setFitMode('fit');
    },
    [computeFitScale],
  );

  // 翻转
  const flipH = useCallback(
    () => setView((v) => ({ ...v, flipH: !v.flipH })),
    [],
  );
  const flipV = useCallback(
    () => setView((v) => ({ ...v, flipV: !v.flipV })),
    [],
  );

  // 拖动平移（任意缩放均可）
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: viewRef.current.translateX,
      ty: viewRef.current.translateY,
    };
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      setView((v) => ({
        ...v,
        translateX: start.tx + (e.clientX - start.x),
        translateY: start.ty + (e.clientY - start.y),
      }));
    };
    const handleUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging]);

  // 滚轮缩放
  useEffect(() => {
    const container = containerRef.current;
    if (!open || !container || !imageReady) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? WHEEL_SCALE_STEP : 1 / WHEEL_SCALE_STEP;
      zoomAtPoint(event.clientX, event.clientY, delta);
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [open, imageReady, zoomAtPoint]);

  // 图片加载完成后自动适应窗口
  const handleImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      if (!img.naturalWidth || !img.naturalHeight) {
        onImageError();
        return;
      }
      setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      setView({ ...INITIAL_STATE, scale: computeFitScale(0) });
      setFitMode('fit');
    },
    [computeFitScale, onImageError],
  );

  // 快捷键只在当前预览内生效，不能冒泡到后台审批或聊天输入。
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (!imageReady) return;
      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault();
          zoomAtCenter(BUTTON_SCALE_STEP);
          break;
        case '-':
          e.preventDefault();
          zoomAtCenter(1 / BUTTON_SCALE_STEP);
          break;
        case '0':
          e.preventDefault();
          applyFit();
          break;
        case '1':
          e.preventDefault();
          applyActual();
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          rotate(e.shiftKey ? -1 : 1);
          break;
        case 'h':
        case 'H':
          e.preventDefault();
          flipH();
          break;
        case 'v':
        case 'V':
          e.preventDefault();
          flipV();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setView((v) => ({ ...v, translateX: v.translateX + 50 }));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setView((v) => ({ ...v, translateX: v.translateX - 50 }));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setView((v) => ({ ...v, translateY: v.translateY + 50 }));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setView((v) => ({ ...v, translateY: v.translateY - 50 }));
          break;
      }
    },
    [imageReady, zoomAtCenter, applyFit, applyActual, rotate, flipH, flipV],
  );

  const handleClose = requestClose;

  if (!open) return null;

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.written / progress.total) * 100))
      : 0;

  const zoomPct = Math.round(view.scale * 100);

  const transform = `translate(${view.translateX}px, ${view.translateY}px) scale(${view.scale}) rotate(${view.rotation}deg) scaleX(${view.flipH ? -1 : 1}) scaleY(${view.flipV ? -1 : 1})`;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm ${
          closing ? 'modal-backdrop-exit' : 'modal-backdrop-enter'
        }`}
        onClick={handleClose}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-region="image-preview"
        onKeyDown={handleKeyDown}
        onAnimationEnd={onExitAnimationEnd}
        className={`relative w-full max-w-6xl mx-4 h-[88vh] rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl flex flex-col overflow-hidden ${
          closing ? 'modal-panel-exit' : 'modal-panel-enter'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg
              className="w-4 h-4 text-zinc-400 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <h2
              id={titleId}
              className="text-sm font-medium text-zinc-200 truncate"
              title={source.kind === 'sftp' ? source.filePath : fileName}
            >
              {source.kind === 'sftp' ? source.filePath : fileName}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={handleClose}
            className="text-zinc-400 hover:text-zinc-200 text-xl leading-none p-1"
            aria-label="关闭"
          >
            &times;
          </button>
        </div>

        {/* 状态栏 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 border-b border-zinc-700/50 bg-zinc-800/50 flex-shrink-0 text-xs text-zinc-400">
          {hasSize && (
            <span>
              大小: <span>{formatSize(fileSize!)}</span>
            </span>
          )}
          {imgNaturalSize && (
            <span>
              尺寸:{' '}
              <span className="text-zinc-400">
                {imgNaturalSize.w}×{imgNaturalSize.h}
              </span>
            </span>
          )}
          {imageSrc && (
            <span>
              缩放: <span className="text-zinc-400">{zoomPct}%</span>
            </span>
          )}
          {view.rotation !== 0 && (
            <span>
              旋转: <span className="text-zinc-400">{view.rotation}°</span>
            </span>
          )}
          <span className="ml-auto text-zinc-400">
            滚轮缩放 · 拖动平移 · R 旋转 · H/V 翻转 · 0 适应 · 1 实际 · Esc 关闭
          </span>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-center justify-between px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-300 flex-shrink-0"
          >
            <span>{error}</span>
          </div>
        )}

        {/* 图片画布 */}
        <div
          ref={containerRef}
          tabIndex={0}
          role="group"
          aria-label="图片预览"
          aria-busy={imageLoading}
          className="flex-1 min-h-0 flex items-center justify-center relative bg-zinc-900/60 overflow-hidden"
          onDoubleClick={
            imageReady
              ? () => (fitMode === 'fit' ? applyActual() : applyFit())
              : undefined
          }
          style={{
            cursor: isDragging ? 'grabbing' : imageReady ? 'grab' : 'default',
          }}
        >
          {imageLoading && (
            <div
              role="status"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-900 z-10"
            >
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <svg
                  aria-hidden="true"
                  className="w-4 h-4 animate-spin motion-reduce:animate-none"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                正在加载图片...
              </div>
              {progress && progress.total > 0 && (
                <div className="w-64 flex flex-col gap-1">
                  <div className="h-1.5 rounded-full bg-zinc-700 overflow-hidden">
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

          {imageSrc && (
            <img
              key={imageSrc}
              ref={imgRef}
              src={imageSrc}
              alt={fileName}
              onLoad={handleImgLoad}
              onError={onImageError}
              onMouseDown={imageReady ? handleMouseDown : undefined}
              draggable={false}
              className="select-none max-w-none max-h-none"
              style={{
                transform,
                opacity: imageReady ? 1 : 0,
                transition: 'none',
              }}
            />
          )}

          {!loading && !imageSrc && !error && (
            <div className="text-sm text-zinc-500">无预览内容</div>
          )}
        </div>

        {/* 工具栏 */}
        <div className="flex items-center justify-center gap-1 px-4 py-2.5 border-t border-zinc-700 flex-shrink-0 bg-zinc-800/80">
          <ToolbarButton
            title="左旋转 (Shift+R)"
            onClick={() => rotate(-1)}
            disabled={!imageReady}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
              />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            title="右旋转 (R)"
            onClick={() => rotate(1)}
            disabled={!imageReady}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 10H11a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6"
              />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            title="水平翻转 (H)"
            onClick={flipH}
            disabled={!imageReady}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 3v18M3 8h6l-3 4 3 4H3M21 8h-6l3 4-3 4h6"
              />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            title="垂直翻转 (V)"
            onClick={flipV}
            disabled={!imageReady}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 12h18M8 3v6l4-3 4 3V3M8 21v-6l4 3 4-3v6"
              />
            </svg>
          </ToolbarButton>
          <div className="w-px h-6 bg-zinc-700 mx-1" />
          <ToolbarButton
            title="缩小 (-)"
            label="缩小图片"
            onClick={() => zoomAtCenter(1 / BUTTON_SCALE_STEP)}
            disabled={!imageReady || view.scale <= MIN_SCALE}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7"
              />
            </svg>
          </ToolbarButton>
          <output
            aria-label="图片缩放比例"
            className="text-xs text-zinc-400 w-12 text-center tabular-nums"
          >
            {imageReady ? `${zoomPct}%` : '—'}
          </output>
          <ToolbarButton
            title="放大 (+)"
            label="放大图片"
            onClick={() => zoomAtCenter(BUTTON_SCALE_STEP)}
            disabled={!imageReady || view.scale >= MAX_SCALE}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10h-2M7 10H5M6 9v2"
              />
            </svg>
          </ToolbarButton>
          <div className="w-px h-6 bg-zinc-700 mx-1" />
          <ToolbarButton
            title="适应窗口 (0)"
            label="适应窗口"
            onClick={applyFit}
            active={fitMode === 'fit'}
            disabled={!imageReady}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
              />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            title="实际大小 (1)"
            label="实际大小"
            onClick={applyActual}
            active={fitMode === 'actual'}
            disabled={!imageReady}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </ToolbarButton>
          <div className="w-px h-6 bg-zinc-700 mx-1" />
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
          >
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface ToolbarButtonProps {
  title: string;
  label?: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}

function ToolbarButton({
  title,
  label = title,
  onClick,
  children,
  disabled,
  active,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded-lg transition-colors ${
        active
          ? 'bg-indigo-600 text-white'
          : 'text-zinc-300 bg-zinc-700/50 hover:bg-zinc-700'
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}
