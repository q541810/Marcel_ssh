import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { MAX_PREVIEW_IMAGE_SIZE } from "@/lib/constants";
import { getErrorMessage } from "@/lib/errors";
import type { ImagePreviewSource } from "@/lib/imagePreview";
import { formatSize } from "@/lib/sftp-helpers";
import { sftpPreviewCleanup, sftpPreviewImage } from "@/lib/tauri";
import { subscribeTauriEventReady, type Unsubscribe } from "@/lib/tauriEvent";

interface PreviewState {
  imageSrc: string | null;
  loading: boolean;
  progress: { written: number; total: number } | null;
  error: string | null;
}

interface PreviewProgress {
  previewId: string;
  written: number;
  total: number;
}

interface ImagePreviewSourceOptions {
  open: boolean;
  source: ImagePreviewSource;
  fileSize?: number;
}

const EMPTY_STATE: PreviewState = {
  imageSrc: null,
  loading: false,
  progress: null,
  error: null,
};
const IMAGE_ERROR = "图片无法显示，文件可能已损坏或不再可用。";

/** 只拥有 SFTP 下载产生的临时文件；本地附件 URL 的寿命由调用方管理。 */
export function useImagePreviewSource({
  open,
  source,
  fileSize,
}: ImagePreviewSourceOptions): PreviewState & { onImageError: () => void } {
  const kind = source.kind;
  const sessionId = source.kind === "sftp" ? source.sessionId : "";
  const filePath = source.kind === "sftp" ? source.filePath : "";
  const src = source.kind === "local" ? source.src : "";
  const fallbackSrc = source.kind === "local" ? source.fallbackSrc : undefined;
  const remoteFileSize = source.kind === "sftp" ? fileSize : undefined;

  // 调用方可以内联构造 source；只在原始字段变化时开始新一轮读取。
  const request = useMemo(
    () => ({
      open,
      kind,
      sessionId,
      filePath,
      src,
      fallbackSrc,
      fileSize: remoteFileSize,
    }),
    [open, kind, sessionId, filePath, src, fallbackSrc, remoteFileSize],
  );
  const initialState = useMemo<PreviewState>(() => {
    if (!request.open) return EMPTY_STATE;
    if (request.kind === "local") {
      const imageSrc = request.src || request.fallbackSrc || null;
      return { ...EMPTY_STATE, imageSrc, error: imageSrc ? null : IMAGE_ERROR };
    }
    if (request.fileSize != null && request.fileSize > MAX_PREVIEW_IMAGE_SIZE) {
      return {
        ...EMPTY_STATE,
        error: `图片过大 (${formatSize(request.fileSize)})，预览上限为 ${formatSize(MAX_PREVIEW_IMAGE_SIZE)}，请使用下载功能`,
      };
    }
    return { ...EMPTY_STATE, loading: true };
  }, [request]);
  const [result, setResult] = useState(() => ({
    request,
    state: initialState,
  }));

  // 切换来源的首帧也不展示旧图；旧图片事件只能更新它所属的那轮读取。
  const state = result.request === request ? result.state : initialState;

  useEffect(() => {
    setResult({ request, state: initialState });
    if (!request.open || request.kind !== "sftp" || initialState.error) return;

    let cancelled = false;
    let localPath: string | null = null;
    let unsubscribeProgress: Unsubscribe | null = null;
    const previewId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const update = (changes: Partial<PreviewState>) => {
      if (cancelled) return;
      setResult((current) =>
        current.request === request
          ? { request, state: { ...current.state, ...changes } }
          : current,
      );
    };
    const stopProgress = () => {
      const unsubscribe = unsubscribeProgress;
      unsubscribeProgress = null;
      unsubscribe?.();
    };
    const cleanupLocal = async () => {
      const ownedPath = localPath;
      localPath = null;
      if (!ownedPath) return;
      try {
        await sftpPreviewCleanup(ownedPath);
      } catch {
        // 残留由既有的启动清理兜底，不影响关闭或下一张图片。
      }
    };

    void (async () => {
      try {
        // 必须等注册往返结束，再触发会发出进度事件的下载。
        unsubscribeProgress = await subscribeTauriEventReady<PreviewProgress>(
          "sftp-preview-progress",
          (payload) => {
            if (payload.previewId === previewId) {
              update({
                progress: { written: payload.written, total: payload.total },
              });
            }
          },
        );
        if (cancelled) return;

        const downloaded = await sftpPreviewImage(
          request.sessionId,
          request.filePath,
          previewId,
        );
        // 每轮闭包只记录自己的路径，迟到的结果不会覆盖新图的资源归属。
        localPath = downloaded.localPath;
        if (cancelled) {
          await cleanupLocal();
          return;
        }
        update({ imageSrc: convertFileSrc(localPath), loading: false });
      } catch (err) {
        update({ imageSrc: null, loading: false, error: getErrorMessage(err) });
      } finally {
        // 包括「关闭发生在 await 订阅期间」和下载失败。
        stopProgress();
      }
    })();

    return () => {
      cancelled = true;
      stopProgress();
      void cleanupLocal();
    };
  }, [request, initialState]);

  const imageSrc = state.imageSrc;
  const onImageError = useCallback(() => {
    if (!request.open || !imageSrc) return;
    setResult((current) => {
      if (current.request !== request || current.state.imageSrc !== imageSrc)
        return current;
      if (
        request.kind === "local" &&
        imageSrc === request.src &&
        request.fallbackSrc &&
        request.fallbackSrc !== imageSrc
      ) {
        return {
          request,
          state: {
            ...current.state,
            imageSrc: request.fallbackSrc,
            loading: false,
            error: null,
          },
        };
      }
      return {
        request,
        state: {
          ...current.state,
          imageSrc: null,
          loading: false,
          error: IMAGE_ERROR,
        },
      };
    });
  }, [request, imageSrc]);

  return { ...state, onImageError };
}
