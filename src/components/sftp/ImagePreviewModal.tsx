import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sftpPreviewImage, sftpPreviewCleanup } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';
import { MAX_PREVIEW_IMAGE_SIZE } from '@/lib/constants';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';

interface ImagePreviewModalProps {
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
  sessionId,
  filePath,
  fileName,
  fileSize,
  onClose,
}: ImagePreviewModalProps) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ written: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imgNaturalSize, setImgNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<ViewState>(INITIAL_STATE);
  const [fitMode, setFitMode] = useState<FitMode>('fit');
  const [isDragging, setIsDragging] = useState(false);

  const previewIdRef = useRef<string | null>(null);
  const localPathRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    closing,
    requestClose,
    onAnimationEnd: onExitAnimationEnd,
  } = useAnimatedClose(onClose);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const viewRef = useRef<ViewState>(INITIAL_STATE);
  const fitModeRef = useRef<FitMode>('fit');

  // 同步 ref，供事件处理器读取最新值
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    fitModeRef.current = fitMode;
  }, [fitMode]);

  const sizeExceeded = fileSize > MAX_PREVIEW_IMAGE_SIZE;

  const reset = useCallback(() => {
    setLoading(false);
    setProgress(null);
    setError(null);
    setImageSrc(null);
    setImgNaturalSize(null);
    setView(INITIAL_STATE);
    setFitMode('fit');
    setIsDragging(false);
    previewIdRef.current = null;
    localPathRef.current = null;
    cancelledRef.current = false;
    dragStartRef.current = null;
  }, []);

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

  // 计算适应窗口的缩放倍率
  const computeFitScale = useCallback((): number => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return 1;
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    if (!imgW || !imgH) return 1;
    const containerRect = container.getBoundingClientRect();
    // 旋转 90/270 时宽高对调
    const isRotated = viewRef.current.rotation % 180 !== 0;
    const effectiveW = isRotated ? imgH : imgW;
    const effectiveH = isRotated ? imgW : imgH;
    const scaleW = containerRect.width / effectiveW;
    const scaleH = containerRect.height / effectiveH;
    return Math.min(scaleW, scaleH, 1);
  }, []);

  // 应用适应窗口
  const applyFit = useCallback(() => {
    const scale = computeFitScale();
    setView((v) => ({ ...v, scale, translateX: 0, translateY: 0 }));
    setFitMode('fit');
  }, [computeFitScale]);

  // 应用实际大小
  const applyActual = useCallback(() => {
    setView((v) => ({ ...v, scale: 1, translateX: 0, translateY: 0 }));
    setFitMode('actual');
  }, []);

  // 缩放（以容器中心为锚点）
  const zoomAtCenter = useCallback((delta: number) => {
    setView((v) => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * delta));
      if (newScale === v.scale) return v;
      // 以容器中心为锚点缩放
      return { ...v, scale: newScale, translateX: v.translateX * (newScale / v.scale), translateY: v.translateY * (newScale / v.scale) };
    });
    setFitMode('custom');
  }, []);

  // 缩放（以鼠标位置为锚点）
  const zoomAtPoint = useCallback((mouseX: number, mouseY: number, delta: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = mouseX - rect.left - rect.width / 2;
    const cy = mouseY - rect.top - rect.height / 2;
    setView((v) => {
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * delta));
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
  }, []);

  // 旋转
  const rotate = useCallback((direction: 1 | -1) => {
    setView((v) => ({
      ...v,
      rotation: ((v.rotation + direction * 90) % 360 + 360) % 360,
      translateX: 0,
      translateY: 0,
    }));
    // 旋转后重置为适应窗口
    requestAnimationFrame(() => {
      const scale = computeFitScale();
      setView((v) => ({ ...v, scale }));
      setFitMode('fit');
    });
  }, [computeFitScale]);

  // 翻转
  const flipH = useCallback(() => setView((v) => ({ ...v, flipH: !v.flipH })), []);
  const flipV = useCallback(() => setView((v) => ({ ...v, flipV: !v.flipV })), []);

  // 拖动平移
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (viewRef.current.scale <= 1) return;
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
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? WHEEL_SCALE_STEP : 1 / WHEEL_SCALE_STEP;
    zoomAtPoint(e.clientX, e.clientY, delta);
  }, [zoomAtPoint]);

  // 图片加载完成后自动适应窗口
  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    // 等 naturalWidth 可用后计算 fit
    requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const isRotated = false; // 初始无旋转
      const effectiveW = isRotated ? img.naturalHeight : img.naturalWidth;
      const effectiveH = isRotated ? img.naturalWidth : img.naturalHeight;
      const scaleW = containerRect.width / effectiveW;
      const scaleH = containerRect.height / effectiveH;
      const fitScale = Math.min(scaleW, scaleH, 1);
      setView({ ...INITIAL_STATE, scale: fitScale });
      setFitMode('fit');
    });
  }, []);

  // 加载图片
  useEffect(() => {
    if (!open) return;
    if (sizeExceeded) {
      setError(
        `图片过大 (${formatSize(fileSize)})，预览上限为 ${formatSize(MAX_PREVIEW_IMAGE_SIZE)}，请使用下载功能`,
      );
      return;
    }

    reset();
    cancelledRef.current = false;
    const previewId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    previewIdRef.current = previewId;
    setLoading(true);

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
      cleanupLocal();
    };
  }, [open, sessionId, filePath, sizeExceeded, fileSize, reset, cleanupLocal]);

  // 键盘快捷键
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          requestClose();
          break;
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
          e.preventDefault();
          rotate(e.shiftKey ? -1 : 1);
          break;
        case 'h':
          e.preventDefault();
          flipH();
          break;
        case 'v':
          e.preventDefault();
          flipV();
          break;
        case 'ArrowLeft':
          if (viewRef.current.scale > 1) {
            e.preventDefault();
            setView((v) => ({ ...v, translateX: v.translateX + 50 }));
          }
          break;
        case 'ArrowRight':
          if (viewRef.current.scale > 1) {
            e.preventDefault();
            setView((v) => ({ ...v, translateX: v.translateX - 50 }));
          }
          break;
        case 'ArrowUp':
          if (viewRef.current.scale > 1) {
            e.preventDefault();
            setView((v) => ({ ...v, translateY: v.translateY + 50 }));
          }
          break;
        case 'ArrowDown':
          if (viewRef.current.scale > 1) {
            e.preventDefault();
            setView((v) => ({ ...v, translateY: v.translateY - 50 }));
          }
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, requestClose, zoomAtCenter, applyFit, applyActual, rotate, flipH, flipV]);

  const handleClose = requestClose;

  if (!open) return null;

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.written / progress.total) * 100))
      : 0;

  const zoomPct = Math.round(view.scale * 100);
  const canDrag = view.scale > 1 && !isDragging;

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
            <h2 className="text-sm font-medium text-zinc-200 truncate">{filePath}</h2>
          </div>
          <button
            onClick={handleClose}
            className="text-zinc-400 hover:text-zinc-200 text-xl leading-none p-1"
            aria-label="关闭"
          >
            &times;
          </button>
        </div>

        {/* 状态栏 */}
        <div className="flex items-center gap-4 px-4 py-1.5 border-b border-zinc-700/50 bg-zinc-800/50 flex-shrink-0 text-xs text-zinc-500">
          <span>
            大小: <span className="text-zinc-400">{formatSize(fileSize)}</span>
          </span>
          {imgNaturalSize && (
            <span>
              尺寸: <span className="text-zinc-400">{imgNaturalSize.w}×{imgNaturalSize.h}</span>
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
          <span className="ml-auto text-zinc-600">滚轮缩放 · 拖动平移 · R 旋转 · H/V 翻转 · 0 适应 · 1 实际 · Esc 关闭</span>
        </div>

        {error && (
          <div className="flex items-center justify-between px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-300 flex-shrink-0">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">
              ✕
            </button>
          </div>
        )}

        {/* 图片画布 */}
        <div
          ref={containerRef}
          className="flex-1 min-h-0 flex items-center justify-center relative bg-zinc-900/60 overflow-hidden"
          onWheel={handleWheel}
          style={{ cursor: isDragging ? 'grabbing' : canDrag ? 'grab' : 'default' }}
        >
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-900 z-10">
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
                      className="h-full bg-green-500 transition-all duration-200"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-zinc-500">
                    <span>
                      {formatSize(progress.written)} / {formatSize(progress.total)}
                    </span>
                    <span>{progressPct}%</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {imageSrc && !loading && (
            <img
              ref={imgRef}
              src={imageSrc}
              alt={fileName}
              onLoad={handleImgLoad}
              onMouseDown={handleMouseDown}
              draggable={false}
              className="select-none max-w-none max-h-none"
              style={{
                transform,
                transition: isDragging ? 'none' : 'transform 0.1s ease-out',
              }}
            />
          )}

          {!loading && !imageSrc && !error && (
            <div className="text-sm text-zinc-500">无预览内容</div>
          )}
        </div>

        {/* 工具栏 */}
        <div className="flex items-center justify-center gap-1 px-4 py-2.5 border-t border-zinc-700 flex-shrink-0 bg-zinc-800/80">
          <ToolbarButton title="左旋转 (Shift+R)" onClick={() => rotate(-1)}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </ToolbarButton>
          <ToolbarButton title="右旋转 (R)" onClick={() => rotate(1)}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6" />
            </svg>
          </ToolbarButton>
          <ToolbarButton title="水平翻转 (H)" onClick={flipH}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v18M3 8h6l-3 4 3 4H3M21 8h-6l3 4-3 4h6" />
            </svg>
          </ToolbarButton>
          <ToolbarButton title="垂直翻转 (V)" onClick={flipV}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12h18M8 3v6l4-3 4 3V3M8 21v-6l4 3 4-3v6" />
            </svg>
          </ToolbarButton>
          <div className="w-px h-6 bg-zinc-700 mx-1" />
          <ToolbarButton title="缩小 (-)" onClick={() => zoomAtCenter(1 / BUTTON_SCALE_STEP)} disabled={view.scale <= MIN_SCALE}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" />
            </svg>
          </ToolbarButton>
          <span className="text-xs text-zinc-400 w-12 text-center tabular-nums">{zoomPct}%</span>
          <ToolbarButton title="放大 (+)" onClick={() => zoomAtCenter(BUTTON_SCALE_STEP)} disabled={view.scale >= MAX_SCALE}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10h-2M7 10H5M6 9v2" />
            </svg>
          </ToolbarButton>
          <div className="w-px h-6 bg-zinc-700 mx-1" />
          <ToolbarButton title="适应窗口 (0)" onClick={applyFit} active={fitMode === 'fit'}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </ToolbarButton>
          <ToolbarButton title="实际大小 (1)" onClick={applyActual} active={fitMode === 'actual'}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
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
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}

function ToolbarButton({ title, onClick, children, disabled, active }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded-lg transition-colors ${
        active
          ? 'bg-green-600 text-white'
          : 'text-zinc-300 bg-zinc-700/50 hover:bg-zinc-700'
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}
