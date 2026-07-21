import { ArrowUpCircle, X } from 'lucide-react';
import { openExternalLink } from '@/lib/externalLinks';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';

interface MobileUpdateToastProps {
  version: string;
  url: string;
  onDismiss: () => void;
}

/** Update notice floating above the tab bar; tap opens the GitHub release (APK download). */
export default function MobileUpdateToast({
  version,
  url,
  onDismiss,
}: MobileUpdateToastProps) {
  const { closing, requestClose, onAnimationEnd } = useAnimatedClose(onDismiss);
  return (
    <div
      onAnimationEnd={onAnimationEnd}
      className={`pointer-events-none absolute inset-x-3 bottom-2 z-40 ${
        closing ? 'mobile-overlay-exit' : 'mobile-sheet-enter'
      }`}
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-zinc-700 bg-zinc-900/95 px-4 py-3 shadow-2xl backdrop-blur-sm">
        <button
          type="button"
          onClick={() => openExternalLink(url)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left active:opacity-80"
        >
          <ArrowUpCircle className="h-6 w-6 flex-shrink-0 text-indigo-400" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">
              新版本 {version} 可用
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              点击前往下载安装包
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={requestClose}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800"
          aria-label="关闭更新提示"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
