import { ArrowUp, Loader2, Square, X } from 'lucide-react';

type SendControlButtonProps = {
  isRunning: boolean;
  isStopping?: boolean;
  isCompacting: boolean;
  disabled: boolean;
  /** 任务运行中且输入区有内容：在停止键旁多出「加入队列」键。 */
  canQueue?: boolean;
  onSend: () => void;
  onStop: () => void;
  onCancelCompaction: () => void;
};

/** 发送 / 停止 / 取消压缩 三态按钮（右下角），运行中有输入时旁边多一个「加入队列」。
 *  三态：任务运行中 = 停止（红）；正在压缩上下文 = 取消压缩（紫，
 *  压缩不能暂停，这是它唯一的出路）；否则 = 发送。
 *  压缩时发送键不能只是「禁用」：那会让用户干等几十秒。
 *
 *  运行中打了字：停止键**留在原处**（不能被「发送」顶掉——用户打字的同时想停掉任务是常事，
 *  让停止键消失就得先清空输入），右侧的主位置给「加入队列」。停止在左、队列在右：
 *  误点队列只是多排一条，误点停止会中断长任务，破坏性大的不放在顺手的主位。 */
export function SendControlButton({
  isRunning,
  isStopping = false,
  isCompacting,
  disabled,
  canQueue = false,
  onSend,
  onStop,
  onCancelCompaction,
}: SendControlButtonProps) {
  return (
    <>
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
              flex-shrink-0 w-8 h-8 mr-0.5 flex items-center justify-center rounded-lg transition-colors duration-120 pressable
              ${
                isRunning
                  ? "bg-red-600 hover:bg-red-500 text-white"
                  : isCompacting
                    ? "bg-violet-600 hover:bg-violet-500 text-white"
                    : "bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-state-mid disabled:text-fg-tertiary disabled:cursor-not-allowed"
              }
            `}
      title={isRunning ? (isStopping ? "正在停止，点击可重试" : "停止") : isCompacting ? "取消压缩" : "发送"}
      aria-label={isRunning ? (isStopping ? "正在停止，点击可重试" : "停止") : isCompacting ? "取消压缩" : "发送"}
    >
      {isRunning ? (
        isStopping ? (
          <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
        ) : (
          <Square size={16} className="fill-current" />
        )
      ) : isCompacting ? (
        <X size={16} strokeWidth={1.5} />
      ) : (
        <ArrowUp size={18} strokeWidth={1.5} />
      )}
    </button>
    {isRunning && canQueue && (
      <button
        type="button"
        onClick={onSend}
        className="flex-shrink-0 w-8 h-8 mr-0.5 flex items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors duration-120 pressable"
        title="加入队列（当前任务完成后自动发送）"
        aria-label="加入队列"
      >
        <ArrowUp size={18} strokeWidth={1.5} />
      </button>
    )}
    </>
  );
}
