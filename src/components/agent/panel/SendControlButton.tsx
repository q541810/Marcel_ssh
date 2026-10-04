type SendControlButtonProps = {
  isRunning: boolean;
  isCompacting: boolean;
  disabled: boolean;
  onSend: () => void;
  onStop: () => void;
  onCancelCompaction: () => void;
};

/** 发送 / 停止 / 取消压缩 三态按钮（右下角）。
 *  三态：任务运行中 = 停止（红）；正在压缩上下文 = 取消压缩（紫，
 *  压缩不能暂停，这是它唯一的出路）；否则 = 发送。
 *  压缩时发送键不能只是「禁用」：那会让用户干等几十秒。 */
export function SendControlButton({
  isRunning,
  isCompacting,
  disabled,
  onSend,
  onStop,
  onCancelCompaction,
}: SendControlButtonProps) {
  return (
    <button
      type="button"
      onClick={
        isRunning
          ? onStop
          : isCompacting
            ? onCancelCompaction
            : onSend
      }
      disabled={disabled}
      className={`
              flex-shrink-0 w-8 h-8 mr-0.5 flex items-center justify-center rounded-lg transition-all duration-150 active:scale-95
              ${
                isRunning
                  ? "bg-red-600 hover:bg-red-500 text-white"
                  : isCompacting
                    ? "bg-violet-600 hover:bg-violet-500 text-white"
                    : "bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed"
              }
            `}
      title={isRunning ? "停止" : isCompacting ? "取消压缩" : "发送"}
      aria-label={isRunning ? "停止" : isCompacting ? "取消压缩" : "发送"}
    >
      {isRunning ? (
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <rect
            x="6"
            y="6"
            width="12"
            height="12"
            rx="1"
            fill="currentColor"
          />
        </svg>
      ) : isCompacting ? (
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
            d="M6 6l12 12M18 6L6 18"
          />
        </svg>
      ) : (
        <svg
          className="w-[18px] h-[18px]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 19V5m-7 7l7-7 7 7"
          />
        </svg>
      )}
    </button>
  );
}
