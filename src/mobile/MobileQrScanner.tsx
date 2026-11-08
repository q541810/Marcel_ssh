import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraOff, Check, RefreshCw, X } from 'lucide-react';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import {
  acceptScannedSyncCode,
  cameraErrorMessage,
  decodeQrFromImageData,
  maskSyncCode,
} from '@/lib/qrScan';
import MobileFullscreenPage from './ui/MobileFullscreenPage';

/** 每帧解码的间隔。60fps 全跑解码会把中端机烧热，8fps 已经足够对准就识别。 */
const DECODE_INTERVAL_MS = 120;

type Phase =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'confirming'; code: string }
  | { kind: 'error'; message: string };

/**
 * 手机端「扫一扫同步码」。
 *
 * 存在理由：手机系统相机扫出来是一段又长又密的文字，用户得在相机 App 与应用之间来回
 * 复制粘贴，还容易只复制了一半。这里扫到就直接填进输入框。
 *
 * 几条硬规矩：
 * - **相机必须及时关掉**。关页面、切后台（`visibilitychange`）、扫到码，任何一条路径都要
 *   `track.stop()`，否则相机会一直亮着、耗电且亮指示灯。`stopStream` 是幂等的。
 * - 扫到之后**先确认再填入**：同步码等同于钥匙，而且镜头可能扫到别人的二维码，
 *   不能让一张 Wi-Fi 码直接顶掉输入框里的内容。
 * - 拿不到相机（没权限、没有相机、被占用、非安全上下文）一律给出具体原因和「重试」，
 *   并明确告诉用户还能返回上一页手动粘贴——这条路永远在。
 */
export default function MobileQrScanner({
  open,
  onClose,
  onAccept,
}: {
  open: boolean;
  onClose: () => void;
  /** 用户点了「使用这个同步码」。 */
  onAccept: (code: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const { closing, requestClose, onAnimationEnd } = useAnimatedClose(onClose);

  const stopStream = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* 已经停了 */
        }
      }
    }
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  /** 扫到一张：立刻关相机（别等用户点确认），震动一下，进确认态。 */
  const handleDetected = useCallback(
    (raw: string) => {
      stopStream();
      const verdict = acceptScannedSyncCode(raw);
      if (!verdict.ok) {
        setPhase({ kind: 'error', message: verdict.reason });
        return;
      }
      try {
        navigator.vibrate?.(30);
      } catch {
        /* 不支持震动就算了 */
      }
      setPhase({ kind: 'confirming', code: verdict.code });
    },
    [stopStream],
  );

  const tick = useCallback(() => {
    if (!runningRef.current) return;
    const video = videoRef.current;
    const width = video?.videoWidth ?? 0;
    const height = video?.videoHeight ?? 0;
    if (video && width > 0 && height > 0) {
      const canvas = canvasRef.current ?? document.createElement('canvas');
      canvasRef.current = canvas;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(video, 0, 0, width, height);
        let image: ImageData | null = null;
        try {
          image = context.getImageData(0, 0, width, height);
        } catch {
          image = null;
        }
        if (image) {
          // 用取回来的 ImageData 自己的尺寸，而不是 video 的：两者本该一致，
          // 但画布被系统缩放、视频帧还没跟上时会有出入，按实际像素解码才稳。
          const decoded = decodeQrFromImageData(image.data, image.width, image.height);
          if (decoded) {
            handleDetected(decoded);
            return;
          }
        }
      }
    }
    timerRef.current = setTimeout(tick, DECODE_INTERVAL_MS);
  }, [handleDetected]);

  /** 打开相机并开始逐帧解码。重试也走这里。 */
  const start = useCallback(async () => {
    stopStream();
    setPhase({ kind: 'starting' });
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setPhase({
        kind: 'error',
        message: '这个环境不允许使用相机。可以返回上一页手动粘贴同步码。',
      });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      setPhase({ kind: 'error', message: cameraErrorMessage(err) });
      return;
    }
    // 等相机期间用户可能已经退出：这时候得把刚拿到的流关掉，不能留在外面。
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stopStream();
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* 自动播放被拒时画面不动，但流已经在跑，下面的逐帧解码仍可能拿到帧 */
    }
    setPhase({ kind: 'scanning' });
    runningRef.current = true;
    timerRef.current = setTimeout(tick, DECODE_INTERVAL_MS);
  }, [stopStream, tick]);

  // 打开就开相机，关闭就关相机。`start` 只依赖稳定的回调，这里不会反复重启。
  useEffect(() => {
    if (!open) {
      stopStream();
      setPhase({ kind: 'starting' });
      return;
    }
    void start();
    return stopStream;
  }, [open, start, stopStream]);

  // 切到后台（锁屏、切应用）必须关相机：Android 会在后台掐掉摄像头，
  // 不主动停的话回到前台是一块黑屏，还得靠用户点重试。
  useEffect(() => {
    if (!open) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopStream();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [open, stopStream]);

  const handleClose = useCallback(() => {
    stopStream();
    requestClose();
  }, [stopStream, requestClose]);

  const handleRescan = useCallback(() => {
    void start();
  }, [start]);

  const handleAccept = useCallback(() => {
    if (phase.kind !== 'confirming') return;
    onAccept(phase.code);
    handleClose();
  }, [phase, onAccept, handleClose]);

  if (!open) return null;

  return (
    <MobileFullscreenPage
      region="mobile-qr-scanner"
      className="bg-black"
      closing={closing}
      onExitAnimationEnd={onAnimationEnd}
      onBack={handleClose}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 px-3 pb-2" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))' }}>
          <div className="min-w-0 flex-1 text-title text-white">扫描同步码</div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white active:bg-white/25"
          >
            <X aria-hidden className="h-5 w-5" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label="相机预览"
            className="h-full w-full object-cover"
          />
          {(phase.kind === 'starting' || phase.kind === 'scanning') && (
            <Viewfinder hint={phase.kind === 'starting' ? '正在打开相机…' : undefined} />
          )}

          {phase.kind === 'error' && (
            <div
              role="alert"
              className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/85 px-8"
            >
              <CameraOff aria-hidden className="h-8 w-8 text-white/70" />
              <p className="text-center text-body leading-relaxed text-white">{phase.message}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={handleRescan}
                  className="flex min-h-12 items-center gap-2 rounded-lg bg-white/15 px-4 text-body text-white active:bg-white/25"
                >
                  <RefreshCw aria-hidden className="h-4 w-4" />
                  重试
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="flex min-h-12 items-center rounded-lg bg-white/15 px-4 text-body text-white active:bg-white/25"
                >
                  手动粘贴
                </button>
              </div>
            </div>
          )}

          {phase.kind === 'confirming' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/85 px-6">
              <div className="w-full max-w-sm space-y-3 rounded-2xl bg-surface-raised p-5">
                <div className="flex items-center gap-2 text-body font-medium text-fg">
                  <Check aria-hidden className="h-4 w-4 text-emerald-400" />
                  扫到了同步码
                </div>
                <div
                  data-testid="scanned-code"
                  className="break-all rounded-lg border border-edge bg-surface/70 px-3 py-2 font-mono text-meta text-fg-secondary"
                >
                  {maskSyncCode(phase.code)}
                </div>
                <p className="text-meta leading-relaxed text-fg-tertiary">
                  同步码里带着解锁数据的钥匙，只在你自己的设备之间传递。确认这是你自己电脑上那张码再用。
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleAccept}
                    className="min-h-12 flex-1 rounded-lg bg-indigo-600 px-4 text-body font-medium text-white active:bg-indigo-500"
                  >
                    使用这个同步码
                  </button>
                  <button
                    type="button"
                    onClick={handleRescan}
                    className="min-h-12 rounded-lg bg-fill px-4 text-body text-fg active:bg-state-strong"
                  >
                    重新扫
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <p className="px-4 pb-3 pt-2 text-center text-meta leading-relaxed text-white/70">
          把电脑上「设置 → 同步 → 添加设备」里的二维码对准取景框，光线充足时更容易识别。
        </p>
      </div>
    </MobileFullscreenPage>
  );
}

/** 取景框：四角标记 + 一行提示。纯装饰，不参与解码。 */
function Viewfinder({ hint }: { hint?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4">
      <div className="relative h-[min(62vw,260px)] w-[min(62vw,260px)]">
        <span className="absolute left-0 top-0 h-8 w-8 rounded-tl-lg border-l-2 border-t-2 border-white/80" />
        <span className="absolute right-0 top-0 h-8 w-8 rounded-tr-lg border-r-2 border-t-2 border-white/80" />
        <span className="absolute bottom-0 left-0 h-8 w-8 rounded-bl-lg border-b-2 border-l-2 border-white/80" />
        <span className="absolute bottom-0 right-0 h-8 w-8 rounded-br-lg border-b-2 border-r-2 border-white/80" />
      </div>
      {hint && (
        <span className="rounded-full bg-black/50 px-3 py-1 text-meta text-white/80" aria-live="polite">
          {hint}
        </span>
      )}
    </div>
  );
}
