import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useFileNavStore } from '@/stores/fileNavStore';

const SHOW_MS = 4500;

/**
 * 文件导航的轻提示（路径不存在、机器没连上、已复制…）。桌面与手机各挂一次（App 根部）。
 * 一条一条替换、自动消失；错误比提示多停一会儿。纯展示，文案都由 `fileNav` 给出。
 */
export default function FileNavToast({ mobile = false }: { mobile?: boolean }) {
  const notice = useFileNavStore((s) => s.notice);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(
      () => useFileNavStore.getState().clearNotice(notice.seq),
      notice.tone === 'error' ? SHOW_MS + 1500 : SHOW_MS - 2000,
    );
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4 ${
        mobile ? 'bottom-[calc(env(safe-area-inset-bottom)+4.75rem)]' : 'bottom-12'
      }`}
    >
      <div
        role={notice.tone === 'error' ? 'alert' : 'status'}
        aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
        className={`pointer-events-auto flex max-w-[min(32rem,100%)] items-start gap-2 rounded-xl surface-glass px-3 py-2 text-body ${
          notice.tone === 'error'
            ? '!border-red-500/30 text-red-200'
            : 'text-fg'
        }`}
      >
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{notice.text}</span>
        <button
          type="button"
          onClick={() => useFileNavStore.getState().clearNotice(notice.seq)}
          className="pressable focus-ring flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-fg-tertiary hover:text-fg"
          aria-label="关闭提示"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
