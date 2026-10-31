import { ArrowUpToLine } from 'lucide-react';

/**
 * 「回到提问前的那段说明」按钮。有 anchor 时点名小标题（用户一眼知道会跳到哪），否则
 * 就是「查看上文」。内联卡片（桌面 / 手机）、浮动条、已回答记录共用。
 */
export function QuestionJumpButton({
  anchor,
  onJump,
  mobile = false,
  className = '',
}: {
  anchor?: string;
  onJump: () => void;
  mobile?: boolean;
  className?: string;
}) {
  const label = anchor ? `查看「${anchor}」` : '查看上文';
  return (
    <button
      type="button"
      onClick={onJump}
      title={anchor ? `跳到上文小标题「${anchor}」` : '跳到提问前的说明'}
      className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-600/15 text-indigo-300 transition-colors ${
        mobile ? 'px-2 py-1 text-[11px] active:bg-indigo-600/30' : 'px-2 py-0.5 text-[11px] hover:bg-indigo-600/30 active:scale-95'
      } ${className}`}
    >
      <ArrowUpToLine className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}
