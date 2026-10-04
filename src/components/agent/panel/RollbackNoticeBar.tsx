type RollbackNoticeBarProps = {
  notice: string;
  onDismiss: () => void;
};

/** 撤回成功提示条。 */
export function RollbackNoticeBar({ notice, onDismiss }: RollbackNoticeBarProps) {
  return (
    <div className="flex-shrink-0 border-t border-zinc-800 bg-zinc-900/90 backdrop-blur animate-fadeIn">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-amber-200">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="w-3.5 h-3.5 flex-shrink-0 text-amber-300"
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
          <span className="truncate">{notice}</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          title="关闭"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
