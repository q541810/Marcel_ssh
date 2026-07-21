import { openExternalLink } from '@/lib/externalLinks';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';

interface Props {
  version: string;
  url: string;
  onDismiss: () => void;
}

export default function UpdateToast({ version, url, onDismiss }: Props) {
  const { closing, requestClose, onAnimationEnd } = useAnimatedClose(onDismiss);
  return (
    <div
      onAnimationEnd={onAnimationEnd}
      className={`fixed bottom-4 right-4 z-50 ${
        closing ? 'animate-slide-down-out' : 'animate-slide-up'
      }`}
    >
      <div className="bg-black text-white rounded-xl shadow-2xl border border-zinc-700 px-4 py-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => openExternalLink(url)}
            className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity"
          >
            <svg className="w-5 h-5 flex-shrink-0 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-white">新版本 {version} 可用</p>
              <p className="text-xs text-zinc-400 mt-0.5">点击前往 GitHub 下载</p>
            </div>
          </button>
          <button
            onClick={requestClose}
            className="flex-shrink-0 p-0.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            aria-label="关闭"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
