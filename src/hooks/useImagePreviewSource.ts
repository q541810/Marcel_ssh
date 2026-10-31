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
  /**
   * 取不到时的归类。`remote` = 图片在另一台设备上、本机还没拿到（跨设备同步的画廊）；
   * `other` = 其它读取 / 解码失败。界面据此决定是「一行小字」还是醒目的错误条。
   */
  unavailableKind: 'remote' | 'other' | null;
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
  unavailableKind: null,
};
const IMAGE_ERROR = "图片无法显示，文件可能已损坏或不再可用。";

/**
 * 「图片在另一台设备上」这句话本身，用于后端只给了一句底层错误时的兜底文案。
 * 与 T3 的后端错误文案约定：关键字对不上就一律按普通错误显示（宁可不多解释，也不误报）。
 */
export const REMOTE_IMAGE_HINT = "图片在另一台设备上，暂时取不到";

/** 后端说「这张图要从别的设备取」时的关键字。T3 落地后按它的实际文案再对齐一次。 */
const REMOTE_UNAVAILABLE_PATTERN = /另一台设备|其它设备|其他设备|another device|other device|remote device/i;

function isRemoteUnavailable(message: string): boolean {
  return REMOTE_UNAVAILABLE_PATTERN.test(message);
}

/**
 * 图片预览来源的三种结果：`ready` / `loading` / `unavailable`。
 *
 * 状态只由 `imageSrc`、`loading`、`error` 三个既有字段推导，不另存一份 —— 免得两者漂移。
 */
export type ImagePreviewStatus = 'ready' | 'loading' | 'unavailable';

/** 只拥有 SFTP 下载产生的临时文件；本地附件 URL 的寿命由调用方管理。 */
export function useImagePreviewSource({
  open,
  source,
  fileSize,
}: ImagePreviewSourceOptions): PreviewState & { status: ImagePreviewStatus; onImageError: () => void } {
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
      return imageSrc
        ? { ...EMPTY_STATE, imageSrc }
        : { ...EMPTY_STATE, error: IMAGE_ERROR, unavailableKind: 'other' };
    }
    if (request.fileSize != null && request.fileSize > MAX_PREVIEW_IMAGE_SIZE) {
      return {
        ...EMPTY_STATE,
        error: `图片过大 (${formatSize(request.fileSize)})，预览上限为 ${formatSize(MAX_PREVIEW_IMAGE_SIZE)}，请使用下载功能`,
        unavailableKind: 'other',
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
        const message = getErrorMessage(err);
        update({
          imageSrc: null,
          loading: false,
          error: message,
          unavailableKind: isRemoteUnavailable(message) ? 'remote' : 'other',
        });
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
            unavailableKind: null,
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
          // 解码失败不是「在另一台设备上」，归普通错误。
          unavailableKind: "other",
        },
      };
    });
  }, [request, imageSrc]);

  // 三种结果：有图 = ready；没图但还在读 = loading；没图且已报错 = unavailable。
  const status: ImagePreviewStatus = state.imageSrc
    ? "ready"
    : state.loading
      ? "loading"
      : state.error
        ? "unavailable"
        : "loading";

  return { ...state, status, onImageError };
}
